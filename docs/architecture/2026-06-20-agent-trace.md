# Agent trace architecture

The trace is the display channel of one agent run: every event a run shows a
reader (log lines, stages, streamed text, tool cards, usage) is one
`AgentEvent` emitted on its `AgentTrace`. One agent-general interface carries
the primitives; the TeXRA-specific helpers are plain functions over that
interface, so there is a single runtime implementation behind both. The trace
is not the run's state: the rows a run continues from commit through its run
history (`RunCell.append`), never through the trace.

```
                 call sites (run loop, tools, model invoker, …)
                                      │
                         trace.<method>(...) / helper(trace, ...)
                                      │
                                      ▼
            ┌───────────────────────────────────────────────────┐
            │ packages/harness/src/agent/trace/helpers.ts        │
            │ TeXRA helpers, plain functions over an AgentTrace: │
            │ logSdkError / logProviderError / logProgressStatus │
            │ logUserMessage / logContextManagementEvent /       │
            │ startCompactionActivity                            │
            └─────────────────────────┬─────────────────────────┘
                                      ▼
            ┌───────────────────────────────────────────────────┐
            │ AgentTrace (interface, AgentTrace.ts)              │
            │ emit · debug/info/warn/error · openStage ·         │
            │ openRun · openToolCard                             │
            └─────────────────────────┬─────────────────────────┘
                                      │ implemented by
                                      ▼
            ┌───────────────────────────────────────────────────┐
            │ TraceEmitter (TraceEmitter.ts)                     │
            │ fans each event out to the sinks it was built with │
            └───────────────┬───────────────────┬───────────────┘
                            ▼                   ▼
            ┌──────────────────────┐ ┌──────────────────────────┐
            │ session.log.publish  │ │ session.trace.tap        │
            │ a display row on the │ │ the run's trace port:    │
            │ session event table  │ │ every listener of the    │
            │ (a chunk: transient  │ │ run (its `events`)       │
            │ text, never a row)   │ │                          │
            └──────────────────────┘ └──────────────────────────┘
```

A run's trace is built in `AgentLaunchContext.ts` with those two sinks; a
delegated child's trace (`packages/harness/src/tools/delegation/childRun.ts`)
publishes to its session log only. Readers never subscribe to the emitter:
the progress view and the desktop renderer read the session view folded from
the event table, and an SDK caller reads its run handle's `events`, which listens on the
run's trace port.

Not every product event needs a named helper. Most cases of the `AgentEvent`
union (usage, context state, tool cards) are emitted directly with
`trace.emit({ type, ... })`, and low-traffic, TeXRA-specific facts ride a log
call (`trace.info(text, { messageType, data })`) instead of a dedicated
helper. A plugin's own facts are `plugin.fact` rows (`ToolResult.facts`),
never a log payload.

## Where things live

```
packages/harness/src/agent/trace/        ← agent-general (no TeXRA)
├── events.ts          ← AgentEvent: the session event schema's trace arms
├── AgentTrace.ts      ← the interface and its handles
├── TraceEmitter.ts    ← the implementation, and runEventDraft
├── helpers.ts         ← TeXRA helpers as functions over AgentTrace
└── index.ts           ← the module's public surface

packages/harness/src/controllers/session/runTrace.ts
                       ← each run's trace sink: rows in publisher order,
                         transient streamed text, what the run left open

packages/harness/src/logger/             ← host diagnostics, not the trace
├── logSink.ts         ← the host sink: entry shape, rendering, writeLogEntry
├── effectLog.ts       ← withLogChannel for Effect.log*
└── redaction.ts       ← provider-key redaction for logged text

packages/harness/src/transcript/         ← run transcripts read from rows
├── completedRunArchive.ts ← a run's conversation, rebuilt from its committed rows
└── traceAssembler.ts  ← a static trace document from the run's rows

packages/texra/src/telemetry/
└── UsageLogService.ts ← usage write path, fed per priced call by
                         `reportUsage` (`packages/harness/src/agent/runtime/run/pricing.ts`)
```

## The emit boundary

`TraceEmitter.emit` is the one place an event leaves a run. It hands the
event to each sink in order and catches what a sink throws, writing a `warn`
line to the host log sink (`writeLogLine`) so one bad sink cannot break the
run and its fault stays diagnosable. Once the run ends, `close()` drops the
sinks, so an event emitted afterwards reaches nobody. A log entry belongs to
the stage named in its `stageId` option, or to no stage; the emitter keeps no
implicit stage stack.

`runEventDraft` turns an event into its row on the run's aggregate.
`stream.chunk` is the one transient arm: it has no row, and the session graph
carries its text instead.

## Adding a new event case

1. Declare the arm in the session event schema
   (`packages/harness/src/shared/schemas/sessionEvent.ts`, or the trace arms in
   `packages/harness/src/shared/schemas/traceEvent.ts`), then add its type to
   the `AgentEvent` union in `packages/harness/src/agent/trace/events.ts`.
2. Handle it where the session view folds rows
   (`packages/harness/src/shared/session/sessionView.ts`) and in any renderer
   that switches on the row type.
3. Add a sugar method on `AgentTrace` that reduces to `emit({type:'…'})`
   only when many call sites need it, or, if the case is TeXRA-specific, a
   helper function over `AgentTrace` in `helpers.ts`.

The schema is the single source of truth: a renderer that switches
exhaustively on the row type fails to compile until it handles the new case.
