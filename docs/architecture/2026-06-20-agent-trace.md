# Agent trace architecture

The trace channel is the single emission point for every event a TeXRA
agent run produces. One agent-general interface carries the primitives;
the TeXRA-specific helpers are plain functions over that interface, so
there is a single runtime implementation behind both.

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
                          │  src/agent/trace/helpers.ts            │
                          │  src/agent/trace/toolUseHelpers.ts     │
                          │  ────────────────────────────────────  │
                          │  TeXRA helpers — plain functions       │
                          │  taking an AgentTrace:                 │
                          │  • logSdkError / logProgressStatus     │
                          │  • logUserMessage / logFilesLoaded     │
                          │  • logFileCategory / logWebSearch      │
                          │  • startToolUseCard / endToolUseCard   │
                          │  • debugInternal / logInternal / …     │
                          └────────────────────┬───────────────────┘
                                               │  call
                                               ▼
                          ┌────────────────────────────────────────┐
                          │  src/agent/trace/AgentTrace   (TYPE)   │
                          │  ────────────────────────────────────  │
                          │  agent-general SDK surface             │
                          │  • emit / subscribe                    │
                          │  • activeStageId                       │
                          │  • debug / info / warn / error         │
                          │  • openStage / openStream              │
                          │  • usage / contextState                │
                          │  • toolStart / toolEnd                 │
                          │  • responseFinalized                   │
                          │  • domain (escape hatch)               │
                          └────────────────────┬───────────────────┘
                                               │
                                    implemented by
                                               │
                                               ▼
                          ┌────────────────────────────────────────┐
                          │  src/agent/trace/TraceEmitter (CLASS)  │
                          │     the one implementation             │
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
            │ channelTrace.attach-│                       │ TexraTranscriptRecorder │
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
dedicated named helper.

## Where things live

```
src/agent/trace/                  ← agent-general (no MESSAGE_TYPES, no TeXRA)
├── events.ts                     ← AgentEvent discriminated union
├── AgentTrace.ts                 ← lean SDK interface
├── TraceEmitter.ts               ← in-process implementation
├── noopTrace.ts                  ← default for SDK consumers
├── channelTrace.ts               ← createChannelTrace + attachChannelSubscriber
├── helpers.ts                    ← TeXRA helpers as functions over AgentTrace
├── toolUseHelpers.ts             ← tool-use card helpers
└── index.ts                      ← the module's public surface

src/logger/                       ← channel output and redaction only
├── logUtils.ts                   ← channel sink, createLog, debug/info/warn/error
└── redaction.ts                  ← provider-key redaction for logged text

src/transcript/                   ← TeXRA transcript plane
├── TexraTranscriptRecorder.ts    ← subscriber → StreamLogStore (transcript)
└── StreamLogStore.ts             ← transcript persistence (file-backed)

src/telemetry/
└── UsageLogService.ts            ← usage write path, fed by
                                    `src/agent/runtime/UsageMonitor.ts`
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
proposal collapsed ten `resolveActiveGroupId()` callsites in the logger
this channel replaced down to this single point.

## Adding a new event arm

1. Extend `AgentEvent` in `src/agent/trace/events.ts`.
2. The exhaustive `switch (event.type)` in `TexraTranscriptRecorder.ts`
   (and any other subscriber) fails to compile until handled.
3. Add a sugar method on `AgentTrace` that reduces to `emit({type:'…'})`,
   or, if the arm is TeXRA-specific, a helper function over `AgentTrace`
   in `helpers.ts`.
4. Update `noopTrace` if the new arm has a return shape.

The discriminated union is the SSoT — interface drift forces a build
break in subscribers, not silent data loss.
