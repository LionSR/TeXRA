/**
 * AgentTrace — SDK surface for agent runs.
 *
 * One discriminated-event channel per run. Subscribers (transcript recorder,
 * Supabase usage reporter, etc.) attach with `subscribe()`. Plain
 * debug/info/warn/error are sugar over `emit()`; stages and streams are
 * stateful handles that also reduce to `emit()`.
 *
 * The TeXRA-internal AgentLogger still exists for the 100+ legacy call sites
 * and now forwards into the trace channel so subscribers see everything.
 * New code (SDK consumers, refactored core) should reach the trace via
 * `RunContext.trace`.
 */
export type {
  AgentEvent,
  ContextStateData,
  ContextStateEvent,
  DomainEvent,
  FilesLoadedEvent,
  LogEvent,
  StageEndEvent,
  StageStartEvent,
  StageStamp,
  StreamChunkEvent,
  StreamEndEvent,
  StreamKind,
  StreamStartEvent,
  TokenUsageStats,
  ToolEndEvent,
  ToolStartEvent,
  ToolStatus,
  UsageEvent,
} from './events';

export type {
  AgentTrace,
  AgentTraceSubscriber,
  DomainEventInput,
  LogOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
} from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export { noopTrace } from './noopTrace';
