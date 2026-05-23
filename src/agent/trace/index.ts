/**
 * AgentTrace — SDK surface for agent runs.
 *
 * One discriminated-event channel per run. Subscribers attach with
 * `subscribe()`. Plain `debug/info/warn/error`, stages, streams, and the
 * domain helpers are all sugar over `emit()`.
 *
 * See `docs/proposals/agent-trace-sdk-surface.md` for the design.
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
  AgentLogStage,
  AgentLogStream,
  AgentTrace,
  AgentTraceSubscriber,
  DomainEventInput,
  LogOptions,
  StagedEmitOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
  ToolStartRef,
} from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export { noopTrace } from './noopTrace';
