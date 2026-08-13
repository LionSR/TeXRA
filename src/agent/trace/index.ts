/**
 * AgentTrace — agent-general SDK surface for agent runs.
 *
 * One discriminated-event channel per run. Subscribers attach with
 * `subscribe()`. Plain `debug/info/warn/error`, stages, streams, and the
 * domain helpers are sugar over `emit()`.
 *
 * TeXRA-specific helpers (`logError`/`latexDiff`/`statistics`/etc.) are
 * plain functions over this interface in `helpers.ts` / `toolUseHelpers.ts`.
 *
 * See `docs/proposals/2026-05-22-agent-trace-sdk-surface.md` for the design.
 */
export type {
  AgentEvent,
  ResultEvent,
  StageStartEvent,
  StatusEvent,
} from './events';
export { RUN_FACT_EVENT_TYPES } from './events';

export type {
  AgentTrace,
  AgentTraceSubscriber,
  StageHandle,
  StreamHandle,
} from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export { noopTrace } from './noopTrace';
export { attachChannelSubscriber, createChannelTrace } from './channelTrace';
export {
  startToolUseCard,
  endToolUseCard,
  emitToolUseCard,
  type ToolUseCardRef,
} from './toolUseHelpers';
export {
  logSdkError,
  logErrorData,
  startCompactionActivity,
  type CompactionActivityOperation,
  logProgressStatus,
  logUserMessage,
  logInternal,
  debugInternal,
  logContextManagementEvent,
  logConversationProgress,
  logWebSearch,
  logWebFetch,
  logLatexdiff,
  logFilesLoaded,
  logFileCategory,
  logMissingOutputs,
  logContextStateSnapshot,
} from './helpers';
