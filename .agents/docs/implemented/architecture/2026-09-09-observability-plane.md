---
created: 2026-09-09
status: implemented
---

# One observability plane: Effect-native diagnostics, trace, and secrets

TeXRA has two observability products and keeps them apart. The **transcript**
is user-facing and durable: `AgentEvent` and `SessionEvent` rows, folded and
rendered by the three hosts. **Diagnostics** are operator-facing and ephemeral:
log entries a host surfaces and nothing replays. What the two used to invent
separately (identity, level, redaction, lifetime) now comes from Effect over
one fiber context. This note describes the plane as built; Effect APIs are
those of the pinned `effect` 4 release candidate.

## 1. Diagnostics: `Effect.log*` at call sites, one sink per host

There is no TeXRA log record type and no logging facade. A producer that can
yield an Effect calls `Effect.log*`. The record is Effect's own
`Logger.formatStructured` entry (`LogEntry` in
`packages/harness/src/logger/logSink.ts`): level, fiber, timestamp, message,
cause, annotations and spans, kept as separate fields all the way to the host.

- **Identity is an annotation.** `withLogChannel(channel)`
  (`packages/harness/src/logger/effectLog.ts`) names the channel once for a
  whole program through `Effect.annotateLogs`; a payload is attached raw as
  the `data` annotation. A tracer span from `Effect.withSpan` or `Effect.fn`
  does not attribute a log entry (the entry's `spans` field reads
  `CurrentLogSpans`, which only `Effect.withLogSpan` writes), so annotations
  are the carrier.
- **One port.** `effectDiagnosticsLayer(minimumLogLevel)`
  (`packages/harness/src/logger/effectDiagnostics.ts`) maps each entry onto
  `writeLogEntry`, and each host installs the destination with `setLogSink`.
  The few synchronous publication points (the trace emitter, pre-runtime and
  shutdown paths) call `writeLogEntry` directly.
- **Level is a runtime fact.** `References.MinimumLogLevel` is provided when a
  host builds its runtime (`processLayer` defaults to `Info`; the desktop
  passes `Debug`; the CLI derives it from `--verbose` / `--quiet`). A
  suppressed entry never builds its message. The level is captured at layer
  build, so it carries only facts that cannot change mid-process.
- **Each host renders with its own facilities.** The extension writes to a
  `LogOutputChannel` (`packages/extension/src/frontend/vscode/vscodeLogSink.ts`),
  whose Output view supplies the user-facing level filter. The desktop appends
  one JSON entry per line to its log file and rotates it on startup
  (`packages/desktop/src/main/desktopAppLog.ts`). The CLI installs its sinks in
  `packages/cli/src/runtime/logSinks.ts`.

The `logger.debugMode` setting does not filter diagnostics. It selects the
transcript's verbose tier: debug-level rows and their payload detail.

## 2. Secrets: `Redacted` at the boundary, a scanner as the net

Provider keys are sealed where they are read. `resolveApiKey`
(`packages/llm/src/providers/apiProviders.ts`) returns
`Redacted.make(value, { label: provider })`, so every holder carries a value
that renders as `<redacted:provider>` in a log, a trace or `JSON.stringify`.
A key is unwrapped only where it is handed to a foreign runtime (a provider
SDK, a subprocess environment), and only through the named `exposeApiKey`, so
those sites stay greppable.

`packages/harness/src/logger/redaction.ts` remains as defence in depth: the
sink redacts each entry once, after rendering its annotations and before any
host sees it, and bounds the rendered value. A host may opt out only for a
local operator terminal whose output is neither persisted nor exported
(`setLogSink(sink, { trusted: true })`).

## 3. Transcript: fixed sinks into the one publisher

A run's `TraceEmitter` (`packages/harness/src/agent/trace/TraceEmitter.ts`)
is built with its sinks and has no subscribe surface. The run's emitter
publishes to the session log and taps the run's trace port
(`AgentLaunchContext.ts`); a child run's emitter publishes to the session
log. `close()` ends the trace with its run. A sink that throws is logged at
`warn` through `writeLogLine` and does not break the run.

Every write to a session's event table is a job on the `SessionEvents` inbox,
so transcript order is commit order (CLAUDE.md, "One publisher, loop-owned
cards"). Trace events reach the inbox through `runEventDraft`.

## 4. Spans

`DiagnosticSpan` (`effectDiagnostics.ts`) bounds span attributes (32 keys,
512 characters, scalar values only) and drops span events and links, so local
diagnostics never carry an operation's return value or error body. No
exporter is installed; `effect/unstable/observability` provides OTLP and
Prometheus layers if an operator ever needs one.

## 5. Non-goals

- **No log persistence** beyond the desktop's diagnostic file.
- **No merge of the transcript and diagnostics planes.** They differ in
  audience, durability and level vocabulary (the transcript's `LogLevel` in
  `packages/harness/src/shared/schemas/log.ts` is not Effect's), and need no
  mapping layer because the logger does not import the transcript's.
- **No metrics plane and no `ErrorReporter`** until a consumer is named.
  Token and cost accounting is transcript data the user sees; an operator
  aggregate would be speculative.
