/**
 * AgentTrace — agent-general SDK surface for agent runs.
 *
 * One discriminated-event channel per run. Subscribers attach with
 * `subscribe()`. Plain `debug/info/warn/error`, stages, streams, and the
 * domain helpers are sugar over `emit()`.
 *
 * Host-specific helpers (TeXRA's `logError`/`latexDiff`/`statistics`/
 * etc.) live on `TexraTrace` in `@logger`, which extends this interface.
 *
 * See `docs/proposals/agent-trace-sdk-surface.md` for the design.
 */
export type {
  AgentEvent,
  ContextStateData,
  ContextStateEvent,
  DomainEvent,
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
  StagedEmitOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
} from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export { noopTrace } from './noopTrace';
export {
  startToolUseCard,
  endToolUseCard,
  emitToolUseCard,
  type ToolUseCardRef,
} from './toolUseHelpers';
export {
  logSdkError,
  logErrorData,
  logProgressStatus,
  logUserMessage,
  logInternal,
  debugInternal,
  logScratchpad,
  logContextManagementEvent,
  logWebSearch,
  logWebFetch,
  logLatexdiff,
  logFilesLoaded,
  logFileCategory,
  logMissingOutputs,
  logContextStateSnapshot,
} from './helpers';
