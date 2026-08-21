# Agent trace architecture

The trace channel is the single emission point for every event a TeXRA
agent run produces. Two interface layers split agent-general primitives
from TeXRA-specific helpers; both share one runtime implementation.

```
                          ┌────────────────────────────────────────┐
                          │              call sites                │
                          │  (model handlers, tools, output mgrs,  │
                          │   commands, tests, …)                  │
                          └────────────────────┬───────────────────┘
                                               │
                                  ctx.trace.<method>(...)
                                               │
                                               ▼
                          ┌────────────────────────────────────────┐
                          │  src/logger/TexraTrace        (TYPE)   │
                          │  ────────────────────────────────────  │
                          │  • logError / logProgress              │
                          │  • latexDiff / missingOutputs          │
                          │  • userMessage / filesLoaded           │
                          │  • logFileCategory                     │
                          │  • emitToolUse / updateToolUse         │
                          │  • startGroup / endGroup / statistics  │
                          │  • debugInternal / logInternal / …     │
                          └────────────────────┬───────────────────┘
                                               │  extends
                                               ▼
                          ┌────────────────────────────────────────┐
                          │  src/agent/trace/AgentTrace   (TYPE)   │
                          │  ────────────────────────────────────  │
                          │  agent-general SDK surface             │
                          │  • emit / subscribe                    │
                          │  • activeStageId / withStage           │
                          │  • debug / info / warn / error         │
                          │  • openStage / openStream              │
                          │  • usage / contextState                │
                          │  • toolStart / toolEnd                 │
                          │  • domain (escape hatch)               │
                          └────────────────────┬───────────────────┘
                                               │
                              implements both interfaces
                                               │
                                               ▼
                          ┌────────────────────────────────────────┐
                          │  src/logger/TexraTraceEmitter (CLASS)  │
                          │     extends TraceEmitter               │
                          │                                        │
                          │  src/agent/trace/TraceEmitter (CLASS)  │
                          │     general primitives only            │
                          │     single-stamp at emit() boundary    │
                          │     AsyncLocalStorage for stage stack  │
                          └────────────────────┬───────────────────┘
                                               │  emit(AgentEvent)
                                               ▼
                                    ┌──────────────────────┐
                                    │   subscribers fan    │
                                    │       out from       │
                                    │   one event channel  │
                                    └──┬───────────────┬───┘
                                       │               │
                       ┌───────────────┘               └────────────────┐
                       ▼                                                ▼
            ┌─────────────────────┐                       ┌─────────────────────────┐
            │ logUtils.attach-    │                       │ TexraTranscriptRecorder │
            │ ChannelSubscriber   │                       │                         │
            │                     │                       │ exhaustive switch on    │
            │ writes formatted    │                       │ event.type → store ops  │
            │ lines to per-       │                       │                         │
            │ channel sink        │                       │ TeXRA-product surface:  │
            │                     │                       │ feeds the webview       │
            │ (VS Code output     │                       │ transcript via         │
            │  channels, console) │                       │ StreamLogStore         │
            └─────────────────────┘                       └─────────────────────────┘
                       │                                                │
                       ▼                                                ▼
            ┌─────────────────────┐                       ┌─────────────────────────┐
            │ outputChannelFactory│                       │     StreamLogStore      │
            │ (host-injected)     │                       │  persists to disk,      │
            │                     │                       │  drives progress view   │
            └─────────────────────┘                       └─────────────────────────┘
```

Not every product event needs a named helper. Low-traffic, TeXRA-specific
arms ride the `domain` escape hatch directly — for example, scratchpad
content is emitted with `trace.domain({ key: 'scratchpad', text })`
(see `src/agent/modelHandlers/ModelHandler.ts`) instead of a
dedicated `logScratchpad` method.

## Where things live

```
src/agent/trace/                  ← agent-general (no MESSAGE_TYPES, no TeXRA)
├── events.ts                     ← AgentEvent discriminated union
├── AgentTrace.ts                 ← lean SDK interface
├── TraceEmitter.ts               ← in-process implementation
└── noopTrace.ts                  ← default for SDK consumers

src/logger/                       ← TeXRA host integration
├── TexraTrace.ts                 ← extends AgentTrace with host helpers
├── TexraTraceEmitter.ts          ← extends TraceEmitter with host helpers
├── noopTexraTrace.ts             ← default for `RunContext.trace`
├── TexraTranscriptRecorder.ts    ← subscriber → StreamLogStore (transcript)
├── logUtils.ts                   ← channel-output sink + subscriber
├── channelTrace.ts               ← createChannelTrace factory (channel output only)
├── StreamLogStore.ts             ← transcript persistence (file-backed)
├── AgentUsageReporter.ts         ← Supabase usage subscriber
├── UsageLogService.ts            ← Supabase write path
└── structuredLogger.ts           ← CLI NDJSON/text logger (CLI use only)
```

## Single-resolve invariant

```
caller                       TraceEmitter                   subscribers
──────                       ────────────                   ───────────
trace.debug(msg)         ─►  emitLog('debug', msg)
                                  │
                                  ▼
                              this.emit({type:'log', …})
                                  │
                                  ▼            ┌── stage stamp resolved
                              stamp stageId    │   ONCE here from
                              from AsyncLocal  ┘   AsyncLocalStorage scope
                                  │
                                  ▼
                              for sub of subscribers ─► sub({type:'log', stageId, …})
                                                          │
                                                          ▼
                                                       handle log event
```

Every sugar method (`logError`, `latexDiff`, `openStage`, `usage`, …)
reduces to one `emit()` call. The §6 precursor cleanup of the original
proposal collapsed ten `resolveActiveGroupId()` callsites in `AgentLogger`
down to this single point.

## Adding a new event arm

1. Extend `AgentEvent` in `src/agent/trace/events.ts`.
2. The exhaustive `switch (event.type)` in `TexraTranscriptRecorder.ts`
   (and any other subscriber) fails to compile until handled.
3. Add a sugar method on `AgentTrace` (or `TexraTrace` if TeXRA-specific)
   that reduces to `emit({type:'…'})`.
4. Update `noopTrace` / `noopTexraTrace` if the new arm has a return shape.

The discriminated union is the SSoT — interface drift forces a build
break in subscribers, not silent data loss.
